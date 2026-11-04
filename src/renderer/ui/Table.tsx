import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cx } from './cx';

/**
 * Table primitives (the Codex): hairline rows, sticky header, numeric columns in
 * mono aligned right, an accent rule on the selected row. Put the table in a
 * scrolling container for the sticky header to stick.
 */
export const Table = ({ className, ...rest }: HTMLAttributes<HTMLTableElement>): ReactNode => (
  <table className={cx('ui-table', className)} {...rest} />
);
export const THead = (p: HTMLAttributes<HTMLTableSectionElement>): ReactNode => <thead {...p} />;
export const TBody = (p: HTMLAttributes<HTMLTableSectionElement>): ReactNode => <tbody {...p} />;

export interface TRProps extends HTMLAttributes<HTMLTableRowElement> {
  selected?: boolean;
  /** The keyboard cursor row (selected rows can be several). */
  current?: boolean;
}
export const TR = ({ selected, current, className, ...rest }: TRProps): ReactNode => (
  <tr
    className={cx(className)}
    data-selected={selected ? '' : undefined}
    data-current={current ? '' : undefined}
    aria-selected={selected}
    {...rest}
  />
);

export interface CellProps {
  /** Right-aligned, mono, tabular numerals. */
  numeric?: boolean;
  mono?: boolean;
}
export const TH = ({
  numeric,
  mono,
  className,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & CellProps): ReactNode => (
  <th className={cx(numeric && 'ui-num', mono && 'mono', className)} scope="col" {...rest} />
);
export const TD = ({
  numeric,
  mono,
  className,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & CellProps): ReactNode => (
  <td className={cx(numeric && 'ui-num', mono && 'mono', className)} {...rest} />
);
